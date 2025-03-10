import numpy as np
from PIL import Image, ImageOps
import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.optim as optim
import matplotlib.pyplot as plt
from torch.utils.data.sampler import SubsetRandomSampler
from torch.utils.data import DataLoader
from torchvision import datasets, transforms
from torchvision.transforms.functional import pad
import numbers
import matplotlib.pyplot as plt
#%matplotlib inline
import torch.nn as nn
import torch.nn.functional as F
from utils_AE import *
import glob
import os

def get_args(forVariableLR=1e-3,forVariableWD=0,forVariableEpoch=50,forVariableBS=1):
    parser = argparse.ArgumentParser(description='Yang Mice Colitis Training')
    parser.add_argument('--lr', default=forVariableLR, type=float, help='learning rate')
    parser.add_argument('--weight_decay', default=forVariableWD, type=float, help='weight decay')
    parser.add_argument('--batch_size', default=forVariableBS, type=int)
    parser.add_argument('--num_workers', default=8, type=int)
    parser.add_argument('--num_epochs', default=forVariableEpoch, type=int, help='Number of epochs in training')
    parser.add_argument('--check_after', default=2, type=int, help='check the network after check_after epoch')

    args = parser.parse_args()
    return args

def get_data_transforms(mean=0.5, std=0.1, APS=175):
    data_transforms = {
        'transf': transforms.Compose([
            transforms.ToTensor()])
            #transforms.Normalize(mean, std)])
    }
    
    return data_transforms

class ConvAutoencoder(nn.Module):
    def __init__(self):
        super(ConvAutoencoder, self).__init__()
       
        #Encoder
        self.conv1 = nn.Conv2d(3, 32, 3, padding=1)
        self.conv2 = nn.Conv2d(32, 64, 3, padding=1)
        self.conv3 = nn.Conv2d(64, 128, 3, padding=1)
        self.pool = nn.MaxPool2d(2, 2)

        self.flatten = nn.Flatten()
        self.dense = nn.Linear(50*50*128,50*50*6)
        self.dense2 = nn.Linear(50*50*6,50*50*128)

       
        #Decoder
        self.t_conv1 = nn.ConvTranspose2d(128, 64, 2, stride=2)
        self.t_conv2 = nn.ConvTranspose2d(64, 32, 2, stride=2)
        self.t_conv3 = nn.ConvTranspose2d(32, 3, 2, stride=2)


    def forward(self, x):
        x = F.relu(self.conv1(x))
        x = self.pool(x)
        x = F.relu(self.conv2(x))
        x = self.pool(x)
        x = F.relu(self.conv3(x))
        x = self.pool(x)
        x = self.flatten(x)
        #x = self.dense(x)
        #x = x.reshape(-1)
        x = F.relu(self.dense(x))
        x = F.relu(self.dense2(x))
        x = x.view(-1, 128, 50, 50)
        x = F.relu(self.t_conv1(x))
        x = F.relu(self.t_conv2(x))
        x = torch.sigmoid(self.t_conv3(x))
              
        return x

def main():
    args = get_args()

    source = '/data01/shared/skobayashi/PAAD_patches_4000X_whiteFiltered_65thresh/forAE/'
    dest = source + 'outputs'

    if not os.path.exists(dest):
        os.mkdir(dest)
    
    train_fol = source + 'train'
    test_fol = source + 'test'
    
    img_trains = [f for f in glob.glob(os.path.join(train_fol, '*png'))]
    img_test = [f for f in glob.glob(os.path.join(test_fol, '*png'))]
    
    #mean, std = get_mean_and_std(data_loader(img_trains,transform=None))
    #print("mean is: " + str(mean))
    #print("std is: " + str(std))
    
    data_transforms = get_data_transforms()
    #data_transforms = get_data_transforms(mean, std, APS)
    #data_transforms = get_data_transforms()
    
    train_set = data_loader(img_trains, transform=data_transforms['transf'])
    test_set = data_loader(img_test, transform=data_transforms['transf'])
    
    train_loader = DataLoader(train_set, batch_size=args.batch_size, shuffle=True, num_workers=0)
    test_loader = DataLoader(test_set, batch_size=args.batch_size, shuffle=True, num_workers=0)
    
    #Instantiate the model
    model = ConvAutoencoder()
    print(model)

    #Loss function
    criterion = nn.BCELoss()

    #Optimizer
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    #optimizer = torch.optim.Adadelta(model.parameters())

    def get_device():
        if torch.cuda.is_available():
            device = 'cuda:0'
        else:
            device = 'cpu'
        return device

    device = get_device()
    print(device)
    model.to(device)
    
    #Epochs
    n_epochs = args.num_epochs
    best_loss = 0
    
    for epoch in range(1, n_epochs+1):
        # monitor training loss
        train_loss = 0.0

        #Training
        for data in train_loader:
            images, _, fn = data
            images = images.to(device)
            optimizer.zero_grad()
            outputs = model(images)
            loss = criterion(outputs, images)
            loss.backward()
            optimizer.step()
            train_loss += loss.item()*images.size(0)
              
        train_loss = train_loss/len(train_loader)
        print('Epoch: {} \tTraining Loss: {:.6f}'.format(epoch, train_loss))

        if train_loss > best_loss:
            best_loss = train_loss
            best_model = copy.deepcopy(model)
            state = {
                'model': best_model,
                'loss': best_loss,
                'args': args,
                'lr': args.lr,
                'saved_epoch': epoch,
            }
            checkpoint_dir = os.path.join(dest,'checkpoint_CAE')
            if not os.path.exists('checkpoint_CAE'):
                    os.mkdir('checkpointRS_CAE')
            save_point = dest + '/checkpoint_CAE/' + 'run' + '_' + 'number'+ '_' + str(run_number) + '_' + 'on' + '_' + timestr + '/'
            if not os.path.isdir(save_point):
                os.mkdir(save_point)

            saved_model_fn = 'CAE_{}_bestLoss_{:.4f}_epoch_{}.pt'.format(args.net_depth,
                                                                        timestr,
                                                                        best_loss,
                                                                        epoch)
            saved_model_fn2 = 'CAE_{}_bestLoss_{:.4f}_epoch_{}_fromStateDict.pt'.format(args.net_depth,
                                                                        timestr,
                                                                        best_loss,
                                                                        epoch)
            torch.save(state, os.path.join(save_point, saved_model_fn))
            torch.save(model.state_dict(), os.path.join(save_point, saved_model_fn2))
            print('=======================================================================')

    
    #Batch of test images
    dataiter = iter(test_loader)
    images, labels, fn = dataiter.next()
    images = images.to(device)
    labels = labels.to(device)

    #Sample outputs
    output = model(images).cpu()
    images = images.cpu()
    
    for i in range(len(output)):
        print(output[i])
        im = transforms.ToPILImage()(output[i]).convert("RGB")
        saveName=str(fn[i])[:-4] + '_reConstructed_50Epoch_noNorm_withDense_largerRep.png'
        savePath = os.path.join(dest,saveName)
        im.save(savePath)
        
        print(images[i])
        orig =transforms.ToPILImage()(images[i]).convert("RGB")
        orig_saveName=str(fn[i])[:-4] + '_orig_50Epoch_noNorm_withDense_largerRep.png'
        orig_savePath = os.path.join(dest,orig_saveName)
        orig.save(orig_savePath)
        
if __name__=='__main__':
    main()